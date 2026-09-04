# PR 52 exact-head diagnostic report

- target: `99ac57e2982afab20e9fa939b842776aefc922eb`
- base: `7176fdad2d5fd8ae42b6e0b89c78783f938d8bc2`

## Reproduction return codes

- static: `1`
- shard 1: `1`
- shard 2: `1`
- shard 3: `1`

## static

```text
  ...
# Subtest: production inventory is reachable only from declared executable entrypoints
not ok 38 - production inventory is reachable only from declared executable entrypoints
  ---
  duration_ms: 8565.375559
  type: 'test'
  location: '/home/runner/work/hepta-paper/hepta-paper/target/paper-core/tests/repository-module-imports.test.mjs:557:1'
  failureType: 'testCodeFailure'
  error: |-
    Expected values to be strictly deep-equal:
    + actual - expected
    
    + [
    +   {
    +     actual: 781,
    +     enforcedBy: [
  location: '/home/runner/work/hepta-paper/hepta-paper/target/paper-core/tests/repository-module-imports.test.mjs:557:1'
  failureType: 'testCodeFailure'
  error: |-
    Expected values to be strictly deep-equal:
    + actual - expected
    
    + [
    +   {
    +     actual: 781,
    +     enforcedBy: [
    +       'production'
    +     ],
    +     file: 'paper-adapters/runtime/os-sandboxed-worker-runner-engine.mjs',
    +     limit: 750,
    +     metric: 'lines'
    +   },
# suites 0
# pass 65
# fail 1
# cancelled 0
# skipped 0
# todo 0
# duration_ms 32005.615331
```

## shard-1

```text
  ...
# Subtest: retirement matrix command runs the isolated capability preflight before the release matrix
not ok 450 - retirement matrix command runs the isolated capability preflight before the release matrix
  ---
  duration_ms: 340.589334
  type: 'test'
  location: '/home/runner/work/hepta-paper/hepta-paper/target/paper-core/tests/package-script-surface.test.mjs:711:1'
  failureType: 'testCodeFailure'
  error: |-
    file:///home/runner/work/hepta-paper/hepta-paper/target/migration/legacy-matrix-reference.mjs:39
      if (!archivePath) throw new Error(`Immutable legacy matrix archive ${resolvedManifest.archiveSha256} not found`);
                              ^
    
    Error: Immutable legacy matrix archive sha256:e431c4c7a51a15d64866b17a07c09dd17c15c32c8dddaccf1a769b1a5942cb9d not found
        at resolveImmutableLegacyMatrixArchive (file:///home/runner/work/hepta-paper/hepta-paper/target/migration/legacy-matrix-reference.mjs:39:27)
        at prepareImmutableLegacyMatrixReference (file:///home/runner/work/hepta-paper/hepta-paper/target/migration/legacy-matrix-reference.mjs:50:23)
  location: '/home/runner/work/hepta-paper/hepta-paper/target/paper-core/tests/package-script-surface.test.mjs:711:1'
  failureType: 'testCodeFailure'
  error: |-
    file:///home/runner/work/hepta-paper/hepta-paper/target/migration/legacy-matrix-reference.mjs:39
      if (!archivePath) throw new Error(`Immutable legacy matrix archive ${resolvedManifest.archiveSha256} not found`);
                              ^
    
    Error: Immutable legacy matrix archive sha256:e431c4c7a51a15d64866b17a07c09dd17c15c32c8dddaccf1a769b1a5942cb9d not found
        at resolveImmutableLegacyMatrixArchive (file:///home/runner/work/hepta-paper/hepta-paper/target/migration/legacy-matrix-reference.mjs:39:27)
        at prepareImmutableLegacyMatrixReference (file:///home/runner/work/hepta-paper/hepta-paper/target/migration/legacy-matrix-reference.mjs:50:23)
        at file:///home/runner/work/hepta-paper/hepta-paper/target/paper-core/bin/run-isolated-command.mjs:51:27
        at ModuleJob.run (node:internal/modules/esm/module_job:343:25)
        at async onImport.tracePromise.__proto__ (node:internal/modules/esm/loader:681:26)
        at async asyncRunEntryPointWithESMLoader (node:internal/modules/run_main:117:5)
    
    Node.js v22.23.1
                              ^
    
    Error: Immutable legacy matrix archive sha256:e431c4c7a51a15d64866b17a07c09dd17c15c32c8dddaccf1a769b1a5942cb9d not found
        at resolveImmutableLegacyMatrixArchive (file:///home/runner/work/hepta-paper/hepta-paper/target/migration/legacy-matrix-reference.mjs:39:27)
        at prepareImmutableLegacyMatrixReference (file:///home/runner/work/hepta-paper/hepta-paper/target/migration/legacy-matrix-reference.mjs:50:23)
        at file:///home/runner/work/hepta-paper/hepta-paper/target/paper-core/bin/run-isolated-command.mjs:51:27
        at ModuleJob.run (node:internal/modules/esm/module_job:343:25)
        at async onImport.tracePromise.__proto__ (node:internal/modules/esm/loader:681:26)
        at async asyncRunEntryPointWithESMLoader (node:internal/modules/run_main:117:5)
    
    Node.js v22.23.1
    
    
    1 !== 0
    
  code: 'ERR_ASSERTION'
  ...
# Subtest: production inventory is reachable only from declared executable entrypoints
not ok 519 - production inventory is reachable only from declared executable entrypoints
  ---
  duration_ms: 8965.113488
  type: 'test'
  location: '/home/runner/work/hepta-paper/hepta-paper/target/paper-core/tests/repository-module-imports.test.mjs:557:1'
  failureType: 'testCodeFailure'
  error: |-
    Expected values to be strictly deep-equal:
    + actual - expected
    
    + [
    +   {
    +     actual: 781,
    +     enforcedBy: [
  location: '/home/runner/work/hepta-paper/hepta-paper/target/paper-core/tests/repository-module-imports.test.mjs:557:1'
  failureType: 'testCodeFailure'
  error: |-
    Expected values to be strictly deep-equal:
    + actual - expected
    
    + [
    +   {
    +     actual: 781,
    +     enforcedBy: [
    +       'production'
    +     ],
    +     file: 'paper-adapters/runtime/os-sandboxed-worker-runner-engine.mjs',
    +     limit: 750,
    +     metric: 'lines'
    +   },
# suites 0
# pass 712
# fail 2
# cancelled 0
# skipped 3
# todo 0
# duration_ms 216123.304305
```

## shard-2

```text
  ...
# Subtest: sandbox copy excludes root runtime state and preserves nested runtime code
not ok 534 - sandbox copy excludes root runtime state and preserves nested runtime code
  ---
  duration_ms: 234.517201
  type: 'test'
  location: '/home/runner/work/hepta-paper/hepta-paper/target/paper-core/tests/os-sandboxed-worker-dataset-exclusion.test.mjs:99:1'
  failureType: 'testCodeFailure'
  error: |-
    ["worker_runtime_executable_support_root_unavailable"]
    
    false !== true
    
  code: 'ERR_ASSERTION'
  name: 'AssertionError'
  expected: true
  location: '/home/runner/work/hepta-paper/hepta-paper/target/paper-core/tests/os-sandboxed-worker-dataset-exclusion.test.mjs:99:1'
  failureType: 'testCodeFailure'
  error: |-
    ["worker_runtime_executable_support_root_unavailable"]
    
    false !== true
    
  code: 'ERR_ASSERTION'
  name: 'AssertionError'
  expected: true
  actual: false
  operator: 'strictEqual'
  stack: |-
    TestContext.<anonymous> (file:///home/runner/work/hepta-paper/hepta-paper/target/paper-core/tests/os-sandboxed-worker-dataset-exclusion.test.mjs:152:10)
    Test.runInAsyncScope (node:async_hooks:214:14)
    Test.run (node:internal/test_runner/test:1047:25)
  ...
# Subtest: pure deletion drill passes in a fresh isolated runtime without reading or writing a key
not ok 692 - pure deletion drill passes in a fresh isolated runtime without reading or writing a key
  ---
  duration_ms: 1.235304
  type: 'test'
  location: '/home/runner/work/hepta-paper/hepta-paper/target/paper-core/tests/release-evidence-selection.test.mjs:1307:1'
  failureType: 'testCodeFailure'
  error: 'Immutable legacy matrix archive sha256:e431c4c7a51a15d64866b17a07c09dd17c15c32c8dddaccf1a769b1a5942cb9d not found'
  code: 'ERR_TEST_FAILURE'
  stack: |-
    resolveImmutableLegacyMatrixArchive (file:///home/runner/work/hepta-paper/hepta-paper/target/migration/legacy-matrix-reference.mjs:39:27)
    TestContext.<anonymous> (file:///home/runner/work/hepta-paper/hepta-paper/target/paper-core/tests/release-evidence-selection.test.mjs:1320:39)
    Test.runInAsyncScope (node:async_hooks:214:14)
    Test.run (node:internal/test_runner/test:1047:25)
    Test.processPendingSubtests (node:internal/test_runner/test:744:18)
  location: '/home/runner/work/hepta-paper/hepta-paper/target/paper-core/tests/release-evidence-selection.test.mjs:1307:1'
  failureType: 'testCodeFailure'
  error: 'Immutable legacy matrix archive sha256:e431c4c7a51a15d64866b17a07c09dd17c15c32c8dddaccf1a769b1a5942cb9d not found'
  code: 'ERR_TEST_FAILURE'
  stack: |-
    resolveImmutableLegacyMatrixArchive (file:///home/runner/work/hepta-paper/hepta-paper/target/migration/legacy-matrix-reference.mjs:39:27)
    TestContext.<anonymous> (file:///home/runner/work/hepta-paper/hepta-paper/target/paper-core/tests/release-evidence-selection.test.mjs:1320:39)
    Test.runInAsyncScope (node:async_hooks:214:14)
    Test.run (node:internal/test_runner/test:1047:25)
    Test.processPendingSubtests (node:internal/test_runner/test:744:18)
    Test.postRun (node:internal/test_runner/test:1173:19)
    Test.run (node:internal/test_runner/test:1101:12)
    async Test.processPendingSubtests (node:internal/test_runner/test:744:7)
  ...
# Subtest: release evidence CLI help, invalid arguments, and missing confirmation are zero-write
ok 693 - release evidence CLI help, invalid arguments, and missing confirmation are zero-write
  ...
# Subtest: runtime build assessments bind current definitions and only claim verified source closure properties
not ok 712 - runtime build assessments bind current definitions and only claim verified source closure properties
  ---
  duration_ms: 1.710058
  type: 'test'
  location: '/home/runner/work/hepta-paper/hepta-paper/target/paper-core/tests/runtime-image-reproducibility.test.mjs:224:1'
  failureType: 'testCodeFailure'
  error: |-
    r
    + actual - expected
    
    + 'sha256:c91e91b0ae7a126e6eaa086f5322259886a9b8856443a6e038e179fdc242b182'
    - 'sha256:c4a72fae2ee10189db7401aac028009d1c58d660edd77820f696e40634687735'
    
  code: 'ERR_ASSERTION'
  location: '/home/runner/work/hepta-paper/hepta-paper/target/paper-core/tests/runtime-image-reproducibility.test.mjs:224:1'
  failureType: 'testCodeFailure'
  error: |-
    r
    + actual - expected
    
    + 'sha256:c91e91b0ae7a126e6eaa086f5322259886a9b8856443a6e038e179fdc242b182'
    - 'sha256:c4a72fae2ee10189db7401aac028009d1c58d660edd77820f696e40634687735'
    
  code: 'ERR_ASSERTION'
  name: 'AssertionError'
  expected: 'sha256:c4a72fae2ee10189db7401aac028009d1c58d660edd77820f696e40634687735'
  actual: 'sha256:c91e91b0ae7a126e6eaa086f5322259886a9b8856443a6e038e179fdc242b182'
  operator: 'strictEqual'
  stack: |-
    TestContext.<anonymous> (file:///home/runner/work/hepta-paper/hepta-paper/target/paper-core/tests/runtime-image-reproducibility.test.mjs:227:12)
  ...
# Subtest: R system packages use an immutable Ubuntu snapshot and exact requested versions
not ok 714 - R system packages use an immutable Ubuntu snapshot and exact requested versions
  ---
  duration_ms: 0.547136
  type: 'test'
  location: '/home/runner/work/hepta-paper/hepta-paper/target/paper-core/tests/runtime-image-reproducibility.test.mjs:290:1'
  failureType: 'testCodeFailure'
  error: "ENOENT: no such file or directory, open 'runtime-images/r-scientific/source-cas/manifest.json'"
  code: 'ENOENT'
  stack: |-
    Object.readFileSync (node:fs:440:20)
    TestContext.<anonymous> (file:///home/runner/work/hepta-paper/hepta-paper/target/paper-core/tests/runtime-image-reproducibility.test.mjs:339:41)
    Test.runInAsyncScope (node:async_hooks:214:14)
    Test.run (node:internal/test_runner/test:1047:25)
    Test.processPendingSubtests (node:internal/test_runner/test:744:18)
  location: '/home/runner/work/hepta-paper/hepta-paper/target/paper-core/tests/runtime-image-reproducibility.test.mjs:290:1'
  failureType: 'testCodeFailure'
  error: "ENOENT: no such file or directory, open 'runtime-images/r-scientific/source-cas/manifest.json'"
  code: 'ENOENT'
  stack: |-
    Object.readFileSync (node:fs:440:20)
    TestContext.<anonymous> (file:///home/runner/work/hepta-paper/hepta-paper/target/paper-core/tests/runtime-image-reproducibility.test.mjs:339:41)
    Test.runInAsyncScope (node:async_hooks:214:14)
    Test.run (node:internal/test_runner/test:1047:25)
    Test.processPendingSubtests (node:internal/test_runner/test:744:18)
    Test.postRun (node:internal/test_runner/test:1173:19)
    Test.run (node:internal/test_runner/test:1101:12)
    async Test.processPendingSubtests (node:internal/test_runner/test:744:7)
  ...
# Subtest: GPU image is self-contained on a public immutable base and registry binds the rebuilt OCI manifest digest
ok 715 - GPU image is self-contained on a public immutable base and registry binds the rebuilt OCI manifest digest
  ...
# Subtest: implementation manifest is the exact byte-hashed transitive empirical promotion closure
not ok 794 - implementation manifest is the exact byte-hashed transitive empirical promotion closure
  ---
  duration_ms: 20.458767
  type: 'test'
  location: '/home/runner/work/hepta-paper/hepta-paper/target/paper-core/tests/system-benchmark-harness-integrity.test.mjs:1015:1'
  failureType: 'testCodeFailure'
  error: |-
    Expected values to be strictly deep-equal:
    + actual - expected
    ... Skipped lines
    
      [
        {
          path: 'paper-adapters/artifacts/artifact-write-receipt-verifier.mjs',
  location: '/home/runner/work/hepta-paper/hepta-paper/target/paper-core/tests/system-benchmark-harness-integrity.test.mjs:1015:1'
  failureType: 'testCodeFailure'
  error: |-
    Expected values to be strictly deep-equal:
    + actual - expected
    ... Skipped lines
    
      [
        {
          path: 'paper-adapters/artifacts/artifact-write-receipt-verifier.mjs',
          sha256: 'sha256:37d05701cd51e66da6199cd322d8b500e3f58018dd1c8147edf528a58e589e53'
        },
    ...
          path: 'paper-adapters/runtime/os-sandboxed-worker-runner-engine.mjs',
    +     sha256: 'sha256:2a963576e1b82215ab1f1c1de6bd5d3dcf3247c5e007e23fb210c19b5bd129dc'
    -     sha256: 'sha256:7529880fced8da744fbfaa30c613c64719a200e83724b5bed0ad052cb4eb4ad6'
# suites 0
# pass 894
# fail 5
# cancelled 0
# skipped 13
# todo 0
# duration_ms 233515.741953
```

## shard-3

```text
  ...
# Subtest: OS sandbox runner returns a cancelled receipt without executing a pre-aborted command
not ok 61 - OS sandbox runner returns a cancelled receipt without executing a pre-aborted command
  ---
  duration_ms: 261.328111
  type: 'test'
  location: '/home/runner/work/hepta-paper/hepta-paper/target/paper-core/tests/automation-executors.test.mjs:260:1'
  failureType: 'testCodeFailure'
  error: |-
    Expected values to be strictly equal:
    + actual - expected
    
    + 'os_sandbox_worker_blocked'
    - 'os_sandbox_worker_cancelled'
                         ^
    
  location: '/home/runner/work/hepta-paper/hepta-paper/target/paper-core/tests/automation-executors.test.mjs:260:1'
  failureType: 'testCodeFailure'
  error: |-
    Expected values to be strictly equal:
    + actual - expected
    
    + 'os_sandbox_worker_blocked'
    - 'os_sandbox_worker_cancelled'
                         ^
    
  code: 'ERR_ASSERTION'
  name: 'AssertionError'
  expected: 'os_sandbox_worker_cancelled'
  actual: 'os_sandbox_worker_blocked'
  operator: 'strictEqual'
  stack: |-
  ...
# Subtest: status detects a pinned object shard replaced during hashing
not ok 381 - status detects a pinned object shard replaced during hashing
  ---
  duration_ms: 32.91246
  type: 'test'
  location: '/home/runner/work/hepta-paper/hepta-paper/target/paper-core/tests/cold-volume-cas-recovery.test.mjs:757:1'
  failureType: 'testCodeFailure'
  error: |-
    Expected values to be strictly deep-equal:
    + actual - expected
    
      [
    +   'cold_volume_cas_object_missing:derivatives'
    -   'cold_volume_cas_object_unsafe:derivatives'
      ]
  location: '/home/runner/work/hepta-paper/hepta-paper/target/paper-core/tests/cold-volume-cas-recovery.test.mjs:757:1'
  failureType: 'testCodeFailure'
  error: |-
    Expected values to be strictly deep-equal:
    + actual - expected
    
      [
    +   'cold_volume_cas_object_missing:derivatives'
    -   'cold_volume_cas_object_unsafe:derivatives'
      ]
    
  code: 'ERR_ASSERTION'
  name: 'AssertionError'
  expected:
    0: 'cold_volume_cas_object_unsafe:derivatives'
  actual:
# (Use `node --trace-warnings ...` to show where the warning was created)
# Subtest: selector verification recomputes every nested design and harness identity
not ok 396 - selector verification recomputes every nested design and harness identity
  ---
  duration_ms: 21.388343
  type: 'test'
  location: '/home/runner/work/hepta-paper/hepta-paper/target/paper-core/tests/empirical-p1-authority.test.mjs:101:1'
  failureType: 'testCodeFailure'
  error: |-
    Expected values to be strictly deep-equal:
    + actual - expected
    ... Skipped lines
    
      [
        {
          path: 'paper-adapters/artifacts/artifact-write-receipt-verifier.mjs',
  location: '/home/runner/work/hepta-paper/hepta-paper/target/paper-core/tests/empirical-p1-authority.test.mjs:101:1'
  failureType: 'testCodeFailure'
  error: |-
    Expected values to be strictly deep-equal:
    + actual - expected
    ... Skipped lines
    
      [
        {
          path: 'paper-adapters/artifacts/artifact-write-receipt-verifier.mjs',
          sha256: 'sha256:37d05701cd51e66da6199cd322d8b500e3f58018dd1c8147edf528a58e589e53'
        },
    ...
          path: 'paper-adapters/runtime/os-sandboxed-worker-runner-engine.mjs',
    +     sha256: 'sha256:2a963576e1b82215ab1f1c1de6bd5d3dcf3247c5e007e23fb210c19b5bd129dc'
    -     sha256: 'sha256:7529880fced8da744fbfaa30c613c64719a200e83724b5bed0ad052cb4eb4ad6'
  ...
# Subtest: a spoofed launcher marker cannot authorize a writable candidate executor
not ok 457 - a spoofed launcher marker cannot authorize a writable candidate executor
  ---
  duration_ms: 1.316109
  type: 'test'
  location: '/home/runner/work/hepta-paper/hepta-paper/target/paper-core/tests/immutable-release-deployment-cli.test.mjs:228:1'
  failureType: 'testCodeFailure'
  error: |-
    The input did not match the regular expression /immutable_release_deployment_executor_not_sealed/u. Input:
    
    'Error: immutable_release_deployment_executor_missing'
    
  code: 'ERR_ASSERTION'
  name: 'AssertionError'
  expected:
  location: '/home/runner/work/hepta-paper/hepta-paper/target/paper-core/tests/immutable-release-deployment-cli.test.mjs:228:1'
  failureType: 'testCodeFailure'
  error: |-
    The input did not match the regular expression /immutable_release_deployment_executor_not_sealed/u. Input:
    
    'Error: immutable_release_deployment_executor_missing'
    
  code: 'ERR_ASSERTION'
  name: 'AssertionError'
  expected:
  actual:
  error: 'immutable_release_deployment_executor_missing'
  stack: |-
    codedError (file:///home/runner/work/hepta-paper/hepta-paper/target/paper-core/bin/immutable-release-deploy-validation.mjs:10:24)
    inspectImmutableReleaseDeploymentExecutorBoundary (file:///home/runner/work/hepta-paper/hepta-paper/target/paper-core/bin/immutable-release-deploy-validation.mjs:132:11)
    inspectImmutableReleaseDeploymentExecutorBoundary (file:///home/runner/work/hepta-paper/hepta-paper/target/paper-core/bin/immutable-release-deploy.mjs:40:10)
    The input did not match the regular expression /immutable_release_deployment_executor_not_sealed/u. Input:
    
    'Error: immutable_release_deployment_executor_missing'
    
  code: 'ERR_ASSERTION'
  name: 'AssertionError'
  expected:
  actual:
  error: 'immutable_release_deployment_executor_missing'
  stack: |-
    codedError (file:///home/runner/work/hepta-paper/hepta-paper/target/paper-core/bin/immutable-release-deploy-validation.mjs:10:24)
    inspectImmutableReleaseDeploymentExecutorBoundary (file:///home/runner/work/hepta-paper/hepta-paper/target/paper-core/bin/immutable-release-deploy-validation.mjs:132:11)
    inspectImmutableReleaseDeploymentExecutorBoundary (file:///home/runner/work/hepta-paper/hepta-paper/target/paper-core/bin/immutable-release-deploy.mjs:40:10)
    file:///home/runner/work/hepta-paper/hepta-paper/target/paper-core/tests/immutable-release-deployment-cli.test.mjs:229:23
    getActual (node:assert:609:5)
    Function.throws (node:assert:757:24)
  expected:
  actual:
  error: 'immutable_release_deployment_executor_missing'
  stack: |-
    codedError (file:///home/runner/work/hepta-paper/hepta-paper/target/paper-core/bin/immutable-release-deploy-validation.mjs:10:24)
    inspectImmutableReleaseDeploymentExecutorBoundary (file:///home/runner/work/hepta-paper/hepta-paper/target/paper-core/bin/immutable-release-deploy-validation.mjs:132:11)
    inspectImmutableReleaseDeploymentExecutorBoundary (file:///home/runner/work/hepta-paper/hepta-paper/target/paper-core/bin/immutable-release-deploy.mjs:40:10)
    file:///home/runner/work/hepta-paper/hepta-paper/target/paper-core/tests/immutable-release-deployment-cli.test.mjs:229:23
    getActual (node:assert:609:5)
    Function.throws (node:assert:757:24)
    TestContext.<anonymous> (file:///home/runner/work/hepta-paper/hepta-paper/target/paper-core/tests/immutable-release-deployment-cli.test.mjs:229:10)
    Test.runInAsyncScope (node:async_hooks:214:14)
    Test.run (node:internal/test_runner/test:1047:25)
    Test.processPendingSubtests (node:internal/test_runner/test:744:18)
  operator: 'throws'
  stack: |-
  ...
# Subtest: production deployment composition wires guarded adapters without touching a host
not ok 463 - production deployment composition wires guarded adapters without touching a host
  ---
  duration_ms: 6.354904
  type: 'test'
  location: '/home/runner/work/hepta-paper/hepta-paper/target/paper-core/tests/immutable-release-deployment-cli.test.mjs:383:1'
  failureType: 'testCodeFailure'
  error: |-
    The input did not match the regular expression /immutable_release_/u. Input:
    
    "Error: ENOENT: no such file or directory, lstat '/run/hepta-paper-deployment'"
    
  code: 'ERR_ASSERTION'
  name: 'AssertionError'
  expected:
  location: '/home/runner/work/hepta-paper/hepta-paper/target/paper-core/tests/immutable-release-deployment-cli.test.mjs:383:1'
  failureType: 'testCodeFailure'
  error: |-
    The input did not match the regular expression /immutable_release_/u. Input:
    
    "Error: ENOENT: no such file or directory, lstat '/run/hepta-paper-deployment'"
    
  code: 'ERR_ASSERTION'
  name: 'AssertionError'
  expected:
  actual:
  error: "ENOENT: no such file or directory, lstat '/run/hepta-paper-deployment'"
  stack: |-
    Object.lstatSync (node:fs:1722:25)
    validateLockRoot (file:///home/runner/work/hepta-paper/hepta-paper/target/paper-adapters/runtime/immutable-release-deployment-lock-repository.mjs:40:23)
    inspectImmutableReleaseDeploymentLock (file:///home/runner/work/hepta-paper/hepta-paper/target/paper-adapters/runtime/immutable-release-deployment-lock-repository.mjs:77:22)
```

## Declaration map: `paper-core/tests/support/gpu-scientific-campaign-release-fixture.mjs`

```text
   1: import crypto from 'node:crypto';
   2: import fs from 'node:fs';
   3: import os from 'node:os';
   4: import path from 'node:path';
   6: import { signAuthorityDocument } from '../../../paper-adapters/authority/authority-signatures.mjs';
   7: import { createFilesystemArtifactRepository } from '../../../paper-adapters/artifacts/filesystem-artifact-repository.mjs';
   8: import {
  11: import {
  14: import {
  18: import {
  21: import { runPackageAdapter } from '../../../paper-adapters/build-package/index.mjs';
  22: import {
  25: import {
  28: import {
  31: import {
  34: import {
  41: import {
  51: import {
  54: import {
  60: import { hashPaperRecord } from '../../../paper-domain/contracts/primitives.mjs';
  61: import { buildExperimentRegistry } from '../../../paper-domain/research/experiment-registry.mjs';
  62: import {
  66: import { hashBytes, hashRecord } from '../../../workflow-kernel/record-hash.mjs';
  67: import {
  71: import {
  75: import {
  79: import {
  83: import {
  86: import {
  89: import { buildDeterministicPdfFixture } from './deterministic-pdf-fixture.mjs';
  91: const canonicalPdeExecutorModule =
  93: const processIsolatedPdeCpuOracleModule =
  95: const canonicalDeepLearningExecutorModule =
  98: export const GPU_RELEASE_TIME = '2026-08-15T00:00:00.000Z';
  99: export const GPU_AUTHORITY_EXPIRED_TIME = '2026-08-21T00:00:00.000Z';
 100: const GPU_UUID = 'GPU-a33875b7-7eb7-679e-df08-19227d3decee';
 101: const H = (label) => hashRecord('GpuScientificCampaignReleaseFixture', { label });
 103: function removeFixtureTree(root) {
 104:   function restoreOwnerWrite(candidate) {
 123: function mutableClock(initial) {
 134: function memoryReceiptLedger() {
 136:   const rows = new Map();
 140:       const receiptId = `gpu-release-fixture:${sequence}`;
 149: function promoteWorkerReceipt(receipt) {
 150:   const promoted = structuredClone(receipt);
 153:   const payload = { ...promoted };
 161: function promotedRunner(runner) {
 178: function gpuCapacityObservation(gpuDeviceSelector = GPU_UUID) {
 186: function gpuEnvironmentBomSpawnSync(executable, args = []) {
 204: function discreteReferenceBytes(gridSize, modes) {
 205:   const spacing = 1 / (gridSize + 1);
 206:   const buffer = Buffer.alloc(gridSize * gridSize * Float64Array.BYTES_PER_ELEMENT);
 207:   const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
 209:     const y = (row + 1) * spacing;
 211:       const x = (column + 1) * spacing;
 214:         const basis = Math.sin(kx * Math.PI * x)
 216:         const continuousEigenvalue = Math.PI ** 2 * (kx ** 2 + ky ** 2);
 217:         const discreteEigenvalue = 4 / spacing ** 2 * (
 234: function pdeFixtureRunner(outputRoot, runtimeRoot) {
 264:       const outputVolume = args.find(
 267:       const outputDirectory = String(outputVolume || '')
 269:       const request = JSON.parse(Buffer.from(options.input).toString('utf8'));
 270:       const solutionRoot = path.join(outputDirectory, 'solutions');
 306: function tensorsFor(model) {
 307:   const chunks = [];
 308:   const tensors = model.layers.flatMap((layer) => [
 317:     const count = tensor.shape.reduce((product, item) => product * item, 1);
 318:     const bytes = Buffer.alloc(count * 4);
 331: function writeDeepLearningFixtureOutputs({ outputDirectory, request }) {
 339:   const predictedClass = dataset.labels.map(() => 0);
 340:   const accuracy = predictedClass.reduce((matches, predicted, index) => (
 343:   const crossEntropy = Math.log(model.classCount);
 344:   const modelSpecification = {
 350:   const trace = {
 363:   const summary = {
 400:   const predictions = {
 424: function deepLearningFixtureRunner(outputRoot, runtimeRoot) {
 455:       const outputVolume = args.find(
 458:       const outputDirectory = String(outputVolume || '')
 460:       const request = JSON.parse(Buffer.from(options.input).toString('utf8'));
 467: function promoteDeepLearningReceipt(receipt) {
 468:   const promoted = structuredClone(receipt);
 472:   const payload = { ...promoted };
 480: async function buildGpuExecution({
 485:   const executionPlan = buildCanonicalGpuScientificCampaignExecutionPlan({
 493:     const formalNodeId = `${campaign.campaignId}:1:formal-verify`;
 494:     const finalCompileNodeId = `${campaign.campaignId}:1:final-compile`;
 495:     const researchNodeId = `${campaign.campaignId}:2:research-verify`;
 540:   const node = {
 551:   const attemptAuthority = buildGpuScientificCampaignAttemptAuthority({
 554:   const attemptRoot = path.join(
 561:   const pdeOutputRoot = path.join(attemptRoot, 'pde-poisson-2d');
 562:   const deepLearningOutputRoot = path.join(
 568:   const pdeExecutor = await withCanonicalCupyPdePoisson2dSandboxRunnerForTest(
 580:   const deepLearningExecutor =
 603:       const gpuSelectorExecutionLeaseDelegation =
 605:       const pdeGpuReceipt = await pdeExecutor.execute({
 620:       const cpuOracleAssurance =
 632:       const pdeScientificPayload = {
 644:       const selectedPdeScientificReceipt = Object.freeze({
 651:       const selectedDeepLearningReceipt = promoteDeepLearningReceipt(
 678:   const executionResult = buildGpuScientificCampaignExecutionResult({
 695: function authorityKey(keyId, role, subjectId, organization, pair) {
 711: function buildQualification({ campaign, gpu, archiveManifest }) {
 712:   const request = buildGpuScientificCampaignQualificationRequest({
 737:   const replayPair = crypto.generateKeyPairSync('ed25519');
 738:   const productionPair = crypto.generateKeyPairSync('ed25519');
 739:   const replayInput = {
 753:   const unsignedReplay = buildGpuScientificCampaignSameDeviceReplayReceipt(
 756:   const replaySigned = signAuthorityDocument(unsignedReplay, {
 761:   const replay = buildGpuScientificCampaignSameDeviceReplayReceipt({
 764:   const productionInput = {
 771:   const unsignedProduction =
 775:   const productionSigned = signAuthorityDocument(unsignedProduction, {
 780:   const production = buildGpuScientificCampaignProductionQualificationAuthority({
 783:   const evidence = buildGpuScientificCampaignQualificationEvidence({
 788:   const roots = [
 811: function readyResearchReport({
 816:   const researchGapPlanHash = H('research-gap-plan');
 817:   const promotionInputSnapshotHash = H('promotion-input-snapshot');
 818:   const experimentRegistry = Object.freeze(buildExperimentRegistry({
 821:   const payload = {
 867: function trustedReleaseAttestor() {
 868:   const pair = crypto.generateKeyPairSync('ed25519');
 869:   const signer = Object.freeze({
 892:       const unsignedPayload = buildCampaignReleaseExecutionAttestationUnsignedPayload({
 914:       const structure = verifyCampaignReleaseExecutionAttestationStructure(
 938: export function revokedGpuAuthorityTrustStore(trustStore, revokedAt) {
 939:   const revoked = structuredClone(trustStore);
 946: export async function createGpuScientificCampaignReleaseFixture(t, {
 950:   const root = fs.mkdtempSync(path.join(
 953:   const workspace = path.join(root, 'source');
 954:   const runtimeRoot = path.join(root, 'runtime');
 975:   const campaign = {
 993:   const gpu = await buildGpuExecution({
 998:   const archive = inspectGpuScientificArtifactBodyArchiveSourceSync({
1005:   const qualification = buildQualification({
1010:   const authorityInspection =
1021:   const gpuProjectionChecks = {
1077:   const gpuResearchEvidence = buildCampaignResearchGpuScientificEvidence({
1086:   const sourceSnapshot = inspectWorkspaceExecutionSnapshot(workspace, {
1089:   const finalResult = {
1096:   const finalCompileNode = {
1104:   const researchVerifyNode = {
1116:   const campaignResearchSourceSnapshot = buildCampaignResearchSourceSnapshot({
1128:   const researchReport = readyResearchReport({
1133:   const researchResult = {
1162:   const packageNode = {
1170:   const clock = mutableClock(GPU_RELEASE_TIME);
1171:   const ledger = memoryReceiptLedger();
1172:   const trustState = {
1176:   const trustStoreProvider = () => {
1180:   const authorityVerifier =
1185:   const artifactRepositoryFactory = (scopeRoot) => (
1193:   const packageInput = Object.freeze({
1238: export { runPackageAdapter };
```

## Declaration map: `paper-core/tests/gpu-scientific-campaign-execution-lease-binding.test.mjs`

```text
   1: import assert from 'node:assert/strict';
   2: import test from 'node:test';
   4: import {
   9: import {
  13: import {
  16: import {
  19: import {
  22: import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
  23: import {
  26: import {
  29: import {
  34: const processIsolatedPdeCpuOracleModule =
  37: const H = (label) => hashRecord(
  42: function workerReceiptWithBinding(workerReceipt, binding) {
  43:   const rebuilt = structuredClone(workerReceipt);
  47:   const payload = { ...rebuilt };
  55: function workerReceiptWithAcquisition(originalWorkerReceipt, overrides) {
  56:   const originalBinding =
  58:   const originalAcquisition =
  60:   const acquisitionPayload = {
  65:   const acquisitionReceipt = {
  72:   const bindingPayload = {
  79:   const binding = {
  92: function deepLearningReceiptWithAcquisition(receipt, overrides) {
  93:   const workerReceipt = workerReceiptWithAcquisition(
  97:   const rebuilt = structuredClone(receipt);
 109: function pdeScientificReceiptWithAcquisition(receipt, overrides, runtimeRoot) {
 110:   const originalGpuReceipt = receipt.gpuReceipt;
 111:   const originalManifest = originalGpuReceipt.artifactManifest;
 112:   const workerReceipt = workerReceiptWithAcquisition(
 116:   const artifactManifest = buildPdePoisson2dGpuArtifactManifest({
 122:   const gpuReceipt = structuredClone(originalGpuReceipt);
 132:   const cpuOracleAssurance =
 143:   const rebuilt = structuredClone(receipt);
 154: function executionResultWithTaskReceipts(result, receipts) {
 155:   const rebuilt = structuredClone(result);
 158:     const taskResult = rebuilt.taskResults[index];
 179: function executionResultWithDeepLearningReceipt(result, receipt) {
 184:   const fixture = await createGpuScientificCampaignReleaseFixture(t, {
 189:   const pdeReceipt = result.taskResults[0].receipt;
 190:   const deepLearningReceipt = result.taskResults[1].receipt;
 195:   const pdeAcquisition = pdeReceipt.gpuReceipt.artifactManifest
 198:   const deepLearningAcquisition = deepLearningReceipt.workerReceipt
 200:   const attemptAuthority = buildGpuScientificCampaignAttemptAuthority({
 205:   const releaseCapsuleManifestHash = H('release-capsule-manifest');
 206:   const releaseCapsuleManifestFileHash = H('release-capsule-manifest-file');
 207:   const releaseAttestationHash = H('release-attestation');
 208:   const qualificationEvidence = fixture.qualification.evidence;
 209:   const promotionEvidence = buildGpuScientificCampaignPromotionEvidence({
 222:   const invalidAcquisitions = [
 237:       const alteredDeepLearningReceipt =
 260:       const forgedResult = executionResultWithDeepLearningReceipt(
 286:     const ownerAuthorityHash = H('shared-non-attempt-owner');
 287:     const alteredPdeReceipt = pdeScientificReceiptWithAcquisition(
 292:     const alteredDeepLearningReceipt = deepLearningReceiptWithAcquisition(
 296:     const alteredPdeAcquisition = alteredPdeReceipt.gpuReceipt.artifactManifest
 299:     const alteredDeepLearningAcquisition = alteredDeepLearningReceipt
 336:     const forgedResult = executionResultWithTaskReceipts(result, [
 360:   const missingBindingReceipt = structuredClone(deepLearningReceipt);
 365:   const workerPayload = {
```

## boundary-checker-locations.txt

```text
No matches.
```

## effective-status-locations.txt

```text
.github/workflows/rust-program-truth.yml:50:            docs/rust/tools/derive-effective-status.py \
.github/workflows/rust-program-truth.yml:51:            docs/rust/tools/verify-effective-status-current.py \
.github/workflows/rust-source-qualification-revalidation.yml:110:          python3 docs/rust/tools/derive-effective-status.py \
.github/workflows/rust-source-qualification-revalidation.yml:118:            --output "$evidence_root/effective-status.v1.json" \
.github/workflows/rust-source-qualification-revalidation.yml:120:          python3 docs/rust/tools/verify-effective-status-current.py \
.github/workflows/rust-source-qualification-revalidation.yml:121:            --artifact "$evidence_root/effective-status.v1.json" \
.github/workflows/rust-source-qualification-revalidation.yml:124:          sha256sum "$evidence_root/effective-status.v1.json" \
.github/workflows/rust-source-qualification-revalidation.yml:125:            > "$evidence_root/effective-status.v1.json.sha256"
docs/qualification/QUALIFICATION_SUBJECT_V3_RUNTIME.md:103:docs/rust/qualification/effective-status-runtime-v2.schema.json
docs/rust/RUST_REWRITE_BACKLOG.md:153:`effective-status.v1.json` only after:
docs/rust/RUST_REWRITE_MASTER_PLAN.md:169:- the `effective-status.v1.json` derivation authenticates workflow producers and
docs/rust/QUALIFICATION_STATE_MACHINE.md:11:an `effective-status.v1.json` artifact for one immutable commit/tree. The
docs/rust/QUALIFICATION_STATE_MACHINE.md:124:validated against `qualification/effective-status-v1.schema.json`. Selected
docs/rust/tools/validate-program-truth.py:24:EFFECTIVE_SCHEMA = QUAL / "effective-status-v1.schema.json"
docs/rust/tools/validate-program-truth.py:58:    "docs/rust/qualification/effective-status-v1.schema.json",
docs/rust/tools/validate-program-truth.py:62:    "docs/rust/tools/derive-effective-status.py",
docs/rust/tools/validate-program-truth.py:63:    "docs/rust/tools/verify-effective-status-current.py",
docs/rust/tools/validate-program-truth.py:269:        "derivedArtifact": "effective-status.v1.json",
docs/rust/tools/validate-program-truth.py:271:        "schema": "qualification/effective-status-v1.schema.json",
docs/rust/tools/validate-program-truth.py:410:        "effectiveSchema": "docs/rust/qualification/effective-status-v1.schema.json",
docs/rust/tools/validate-program-truth.py:492:    for needle in ("workflow_run:", "source-qualification-current", "collect-required-checks.py", "verify-effective-status-current.py"):
docs/rust/tools/validate-program-truth.py:506:        DOC / "RUST_REWRITE_MASTER_PLAN.md": ("plan v4.1", "source_implemented", "effective-status.v1.json"),
docs/rust/tools/derive-effective-status.py:59:    parser.add_argument("--effective-schema", default="docs/rust/qualification/effective-status-v1.schema.json", type=Path)
docs/rust/tools/derive-effective-status.py:209:        "derivedArtifact": "effective-status.v1.json",
docs/rust/tools/derive-effective-status.py:210:        "schema": "qualification/effective-status-v1.schema.json",
docs/rust/tools/derive-effective-status.py:285:            fail("worktree is not clean before effective-status derivation")
docs/rust/tools/derive-effective-status.py:354:        Path("docs/rust/tools/derive-effective-status.py"),
docs/rust/tools/derive-effective-status.py:355:        Path("docs/rust/tools/verify-effective-status-current.py"),
docs/rust/tools/derive-effective-status.py:404:            "revalidatorPath": "docs/rust/tools/verify-effective-status-current.py",
docs/rust/tools/derive-effective-status.py:435:            fail("source identity changed during effective-status derivation")
docs/rust/tools/derive-effective-status.py:437:            fail("worktree became dirty during effective-status derivation")
docs/rust/tools/run-qualification-subject-v3.sh:25:  docs/rust/tools/derive-effective-status.py \
docs/rust/tools/run-qualification-subject-v3.sh:26:  docs/rust/tools/verify-effective-status-current.py \
docs/rust/tools/run-qualification-subject-v3.sh:53:python3 docs/rust/tools/derive-effective-status.py \
docs/rust/tools/run-qualification-subject-v3.sh:61:  --output "$EVIDENCE_ROOT/effective-status.v1.json" \
docs/rust/tools/run-qualification-subject-v3.sh:64:  --schema docs/rust/qualification/effective-status-v1.schema.json \
docs/rust/tools/run-qualification-subject-v3.sh:65:  --instance "$EVIDENCE_ROOT/effective-status.v1.json" \
docs/rust/tools/run-qualification-subject-v3.sh:87:  --legacy-effective "$EVIDENCE_ROOT/effective-status.v1.json" \
docs/rust/tools/run-qualification-subject-v3.sh:89:  --output "$EVIDENCE_ROOT/effective-status.v2.json" \
docs/rust/tools/run-qualification-subject-v3.sh:92:  --schema docs/rust/qualification/effective-status-runtime-v2.schema.json \
docs/rust/tools/run-qualification-subject-v3.sh:93:  --instance "$EVIDENCE_ROOT/effective-status.v2.json" \
docs/rust/tools/run-qualification-subject-v3.sh:124:  --artifact "$EVIDENCE_ROOT/effective-status.v2.json" \
docs/rust/tools/run-qualification-subject-v3.sh:131:  "$EVIDENCE_ROOT/effective-status.v1.json" \
docs/rust/tools/run-qualification-subject-v3.sh:133:  "$EVIDENCE_ROOT/effective-status.v2.json" \
docs/rust/tools/test-plan-v4-qualification.py:20:DERIVE = TOOLS / "derive-effective-status.py"
docs/rust/tools/test-plan-v4-qualification.py:21:VERIFY = TOOLS / "verify-effective-status-current.py"
docs/rust/tools/test-plan-v4-qualification.py:27:EFFECTIVE_SCHEMA = ROOT / "docs/rust/qualification/effective-status-v1.schema.json"
docs/rust/tools/test-plan-v4-qualification.py:166:        output = root / "effective-status.v1.json"
docs/rust/tools/verify_effective_status_v2_current.py:40:        default="docs/rust/tools/verify-effective-status-current.py",
docs/rust/tools/verify_effective_status_v2_current.py:122:        legacy_path = Path(directory) / "legacy-effective-status.v1.json"
docs/rust/tools/verify-effective-status-current.py:2:"""Revalidate an effective-status artifact against the latest producer snapshot.
docs/rust/tools/verify-effective-status-current.py:42:    parser.add_argument("--effective-schema", default="docs/rust/qualification/effective-status-v1.schema.json", type=Path)
docs/rust/tools/verify-effective-status-current.py:55:        fail("repository changed since effective-status derivation")
docs/rust/tools/verify-effective-status-current.py:57:        fail("source commit/tree changed since effective-status derivation")
docs/rust/tools/verify-effective-status-current.py:59:        fail("pull-request subject changed since effective-status derivation")
docs/rust/tools/verify-effective-status-current.py:61:        fail("required context policy changed since effective-status derivation")
docs/rust/EVIDENCE_AND_QUALIFICATION_MODEL.md:13:effective source     -> effective-status.v1.json workflow artifact
docs/rust/DOCUMENTATION_INDEX.md:43:qualification/effective-status-v1.schema.json
docs/rust/OPERATIONS_RUNBOOK.md:15:effective result  effective-status.v1.json workflow artifact
docs/rust/OPERATIONS_RUNBOOK.md:35:   - `effective-status.v1.json`;
docs/rust/qualification/source-required-checks.v1.json:47:    "effectiveSchema": "docs/rust/qualification/effective-status-v1.schema.json",
docs/rust/qualification/effective-status-runtime-v2.schema.json:3:  "$id": "https://github.com/TrillionniumFoundation/hepta-paper/docs/rust/qualification/effective-status-runtime-v2.schema.json",
docs/rust/qualification/effective-status-v1.schema.json:3:  "$id": "https://trillionnium.foundation/schemas/hepta-paper/rust-effective-status-v1.schema.json",
docs/rust/qualification/effective-status-v1.schema.json:133:        "revalidatorPath": {"const": "docs/rust/tools/verify-effective-status-current.py"}
docs/rust/CURRENT_STATUS.md:92:- `qualification/effective-status-v1.schema.json` validates the complete derived
docs/rust/CURRENT_STATUS.md:190:   schema-validate `effective-status.v1.json`, then pass
docs/rust/current-status.v1.json:1:{"schemaVersion":1,"program":"hepta-paper-rust-rewrite","truthStatus":"canonical","generatedFrom":{"repository":"TrillionniumFoundation/hepta-paper","baselineBranch":"codex/rust-broker-service-20260828","baselineCommit":"80223a2531de32ceeeab7d5d4e6c9b36a605716f","baselineTree":"cee44bee7bf42f5a7287de14700b83985f5e3557","planVersion":"4.1"},"statusVocabulary":["not_started","design_ready","source_implemented","source_qualified","hosted_installed_qualified","target_host_qualified","external_authority_qualified","blocked_external","retired"],"evidenceTiers":["none","design","source","hosted_installed","target_host","external_authority"],"current":{"productStage":"release_candidate_source_requalification","staticTruthMode":"implementation_only","effectiveQualificationSource":"exact_head_workflow_artifact","productionActivation":"disabled","realCodexCredentials":"forbidden","liveProviderCalls":"forbidden","campaignWriterAuthority":"absent","releaseAuthority":"absent","submissionAuthority":"absent","canonicalStatusDocument":"docs/rust/CURRENT_STATUS.md","canonicalPlanDocument":"docs/rust/RUST_REWRITE_MASTER_PLAN.md","canonicalBacklogDocument":"docs/rust/RUST_REWRITE_BACKLOG.md","canonicalParityDocument":"docs/rust/RUST_PARITY_MATRIX.md"},"qualificationPolicy":{"version":2,"staticSourceMaySelfAssertQualified":false,"headChangeInvalidatesEffectiveQualification":true,"zeroJobRunIsFailure":true,"skippedRequiredJobIsFailure":true,"requiredResult":"completed_success","derivedArtifact":"effective-status.v1.json","promotion":"capability_specific_source_implemented_to_source_qualified","externalGapsNeverAutoPromote":true,"supplementalBlockersNeverAutoPromote":true,"schema":"qualification/effective-status-v1.schema.json","producerManifest":"qualification/source-check-producers.v1.json","capabilityEvidence":"qualification/source-capability-evidence.v1.json","requiredCheckOriginBinding":"workflow_id_path_git_blob_sha256_event_pr_run_attempt_job_steps","producerRunMutationInvalidatesEffectiveQualification":true,"fullSchemaValidationRequired":true,"artifactValidity":"live_revalidation_required","revalidationWorkflow":".github/workflows/rust-source-qualification-revalidation.yml","revalidationContext":"source-qualification-current"},"currentStatusRows":{"Foundation contracts":"source_implemented","Broker protocol/journal":"source_implemented","Durable pre-exec gate":"source_implemented","Workspace mutation authority":"source_implemented","Compatibility kernel":"source_implemented","Read-only Rust campaign plane":"source_implemented","Local author/reviewer slice":"source_implemented","Rust campaign writer":"source_implemented","Scientific evidence orchestration":"source_implemented","Cutover/retirement contracts":"source_implemented","Protected main merge boundary":"blocked_external","Trusted legacy matrix replay":"blocked_external","Production target host":"blocked_external","Real Codex credentials/provider":"blocked_external","Release/KMS/WORM/submission":"blocked_external"},"workstreams":[{"id":"FND","name":"Foundation contracts and protocol","status":"source_implemented","evidenceTier":"design"},{"id":"BRK","name":"Codex broker and durable launch","status":"source_implemented","evidenceTier":"source"},{"id":"WS","name":"Workspace and mutation authority","status":"source_implemented","evidenceTier":"design"},{"id":"CMP","name":"Compatibility and canonicalization","status":"source_implemented","evidenceTier":"design"},{"id":"RO","name":"Read-only Rust control plane","status":"source_implemented","evidenceTier":"design"},{"id":"MVP","name":"Local author-reviewer vertical slice","status":"source_implemented","evidenceTier":"design"},{"id":"DB","name":"Persistent Rust campaign writer","status":"source_implemented","evidenceTier":"design"},{"id":"EVD","name":"Scientific evidence orchestration","status":"source_implemented","evidenceTier":"design"},{"id":"REL","name":"Release and external authority","status":"blocked_external","evidenceTier":"none","repositoryLocalStatus":"source_implemented"},{"id":"CUT","name":"Shadow, cutover and retirement","status":"source_implemented","evidenceTier":"design"}],"backlogItemStatus":{"RUST-FND-001":"source_implemented","RUST-FND-002":"source_implemented","RUST-FND-003":"source_implemented","RUST-FND-004":"source_implemented","RUST-FND-005":"source_implemented","RUST-FND-006":"source_implemented","RUST-FND-007":"source_implemented","RUST-FND-008":"source_implemented","RUST-FND-009":"source_implemented","RUST-FND-010":"source_implemented","RUST-FND-011":"source_implemented","RUST-FND-012":"source_implemented","RUST-FND-013":"source_implemented","RUST-BRK-001":"source_implemented","RUST-BRK-002":"source_implemented","RUST-BRK-003":"source_implemented","RUST-BRK-004":"blocked_external","RUST-BRK-005":"source_implemented","RUST-BRK-006":"source_implemented","RUST-BRK-007":"source_implemented","RUST-BRK-008":"source_implemented","RUST-BRK-009":"source_implemented","RUST-BRK-010":"source_implemented","RUST-BRK-011":"source_implemented","RUST-BRK-012":"source_implemented","RUST-BRK-013":"source_implemented","RUST-BRK-014":"source_implemented","RUST-BRK-015":"blocked_external","RUST-BRK-016":"source_implemented","RUST-BRK-017":"blocked_external","RUST-BRK-018":"source_implemented","RUST-BRK-019":"source_implemented","RUST-BRK-020":"source_implemented","RUST-BRK-021":"source_implemented","RUST-WS-001":"source_implemented","RUST-WS-002":"source_implemented","RUST-WS-003":"source_implemented","RUST-WS-004":"source_implemented","RUST-WS-005":"source_implemented","RUST-WS-006":"source_implemented","RUST-WS-007":"source_implemented","RUST-WS-008":"source_implemented","RUST-WS-009":"source_implemented","RUST-CMP-001":"source_implemented","RUST-CMP-002":"source_implemented","RUST-CMP-003":"source_implemented","RUST-CMP-004":"source_implemented","RUST-CMP-005":"source_implemented","RUST-CMP-006":"source_implemented","RUST-CMP-007":"source_implemented","RUST-CMP-008":"source_implemented","RUST-RO-001":"source_implemented","RUST-RO-002":"source_implemented","RUST-RO-003":"source_implemented","RUST-RO-004":"source_implemented","RUST-RO-005":"source_implemented","RUST-RO-006":"source_implemented","RUST-MVP-001":"source_implemented","RUST-MVP-002":"source_implemented","RUST-MVP-003":"source_implemented","RUST-MVP-004":"source_implemented","RUST-MVP-005":"source_implemented","RUST-MVP-006":"source_implemented","RUST-MVP-007":"source_implemented","RUST-MVP-008":"source_implemented","RUST-MVP-009":"source_implemented","RUST-DB-001":"source_implemented","RUST-DB-002":"source_implemented","RUST-DB-003":"source_implemented","RUST-DB-004":"source_implemented","RUST-DB-005":"source_implemented","RUST-DB-006":"source_implemented","RUST-DB-007":"source_implemented","RUST-DB-008":"source_implemented","RUST-DB-009":"source_implemented"},"parityItemStatus":{"PAR-DET-001":"source_implemented","PAR-DET-002":"source_implemented","PAR-DET-003":"source_implemented","PAR-DET-004":"source_implemented","PAR-DET-005":"source_implemented","PAR-DET-006":"source_implemented","PAR-DET-007":"source_implemented","PAR-DET-008":"source_implemented","PAR-DET-009":"source_implemented","PAR-DET-010":"source_implemented","PAR-DET-011":"source_implemented","PAR-CODEX-001":"source_implemented","PAR-CODEX-002":"source_implemented","PAR-CODEX-003":"source_implemented","PAR-CODEX-004":"source_implemented","PAR-CODEX-005":"source_implemented","PAR-CODEX-006":"source_implemented","PAR-CODEX-007":"retired","PAR-CODEX-008":"blocked_external","PAR-CODEX-009":"blocked_external"},"parityDependencies":{"PAR-DET-001":["RUST-CMP-001","RUST-CMP-004"],"PAR-DET-002":["RUST-CMP-002","RUST-CMP-004"],"PAR-DET-003":["RUST-FND-002","RUST-FND-003"],"PAR-DET-004":["RUST-CMP-007"],"PAR-DET-005":["RUST-RO-002","RUST-DB-008"],"PAR-DET-006":["RUST-DB-002","RUST-DB-005"],"PAR-DET-007":["RUST-DB-001","RUST-DB-003"],"PAR-DET-008":["RUST-BRK-013","RUST-DB-004"],"PAR-DET-009":["RUST-WS-003","RUST-WS-004"],"PAR-DET-010":["RUST-FND-003","RUST-CMP-005","RUST-RO-004"],"PAR-DET-011":["RUST-FND-008","RUST-CMP-007","RUST-DB-004"],"PAR-CODEX-001":["RUST-BRK-001","RUST-BRK-002","RUST-BRK-003","RUST-BRK-012"],"PAR-CODEX-002":["RUST-FND-002","RUST-BRK-012"],"PAR-CODEX-003":["RUST-BRK-011","RUST-BRK-018"],"PAR-CODEX-004":["RUST-BRK-006","RUST-BRK-016","RUST-BRK-020"],"PAR-CODEX-005":["RUST-WS-003","RUST-WS-004","RUST-WS-005"],"PAR-CODEX-006":["RUST-FND-005","RUST-FND-006","RUST-BRK-007"],"PAR-CODEX-007":[],"PAR-CODEX-008":["RUST-BRK-004","RUST-BRK-015"],"PAR-CODEX-009":["RUST-BRK-004","RUST-BRK-015"]},"gaps":[{"id":"GAP-GOV-001","title":"Single machine-readable program truth and stale-document controls","status":"source_implemented","evidenceTier":"design","external":false,"closesWhen":["current status, backlog, parity and external package maps are machine-compared","exact-head workflow derives effective qualification without source self-attestation","historical status files cannot override the canonical set"]},{"id":"GAP-GOV-002","title":"Exact-head and exact-tree qualification evidence","status":"source_implemented","evidenceTier":"design","external":false,"closesWhen":["workflows explicitly checkout the pull-request head SHA","artifacts record head/base/tested commit and tree","mismatch, skipped jobs, zero-job runs and dirty postflight fail closed"]},{"id":"GAP-GOV-003","title":"Protected main exact-head merge boundary","status":"blocked_external","evidenceTier":"none","external":true,"issue":25,"repositoryLocalStatus":"source_implemented","closesWhen":["the active protected-main policy is exported and content-hashed for the current candidate","all seven denial probes are retained","an independent reviewer signs the exact-candidate decision"]},{"id":"GAP-BRK-001","title":"Authorized multi-principal Unix listener accessibility","status":"source_implemented","evidenceTier":"design","external":false,"closesWhen":["shared-group listener mode is explicit","authorized UID succeeds while unauthorized UID fails against a live listener","SO_PEERCRED remains exact"]},{"id":"GAP-BRK-002","title":"Production containment source contract beyond process-group-only supervision","status":"source_implemented","evidenceTier":"design","external":false,"closesWhen":["cgroup-v2 process-set authority is implemented","setsid and double-fork source tests pass","production mode rejects process-group-only and fixture containment"]},{"id":"GAP-BRK-003","title":"Stable worker and lifecycle telemetry contract","status":"source_implemented","evidenceTier":"design","external":false,"closesWhen":["machine error registry is versioned","worker queue journal and reconciliation counters exclude sensitive data"]},{"id":"GAP-HOST-001","title":"Independent target-host listener, gate, schema and systemd qualification","status":"blocked_external","evidenceTier":"none","external":true,"issue":17,"repositoryLocalStatus":"source_implemented","closesWhen":["separately controlled target-host evidence exists","independent Linux reviewer signs approval"]},{"id":"GAP-HOST-002","title":"Production WAL, reboot, disk-full, long-soak and corruption drill","status":"blocked_external","evidenceTier":"none","external":true,"issue":12,"repositoryLocalStatus":"source_implemented","closesWhen":["destructive qualification completes on a dedicated target-host mount","72-hour production-topology soak and recovery evidence are independently reviewed"]},{"id":"GAP-KEY-001","title":"External capability key-owner rotation and compromise drill","status":"blocked_external","evidenceTier":"none","external":true,"issue":14,"repositoryLocalStatus":"source_implemented","closesWhen":["independent key owner performs rotation, revocation, rollback and compromise drills","signed target-host evidence is accepted"]},{"id":"GAP-CODEX-001","title":"Installed authenticated Codex author/reviewer qualification","status":"blocked_external","evidenceTier":"none","external":true,"issue":21,"repositoryLocalStatus":"source_implemented","closesWhen":["qualified Codex executable and CLI surface are pinned","separate homes authenticate under independent credential custody","live author and reviewer canaries pass without leaking authority"]},{"id":"GAP-WS-001","title":"Descriptor-relative COW workspace and mutation verifier","status":"source_implemented","evidenceTier":"design","external":false,"closesWhen":["workspace packages cover root identity, descriptor-bound COW, inventory, mutation policy, prepared results and orphan recovery","replacement, hard-link, cross-device, in-place mutation and partial-copy suites pass on the exact head"]},{"id":"GAP-CMP-001","title":"Historical canonicalization and Node-to-Rust parity kernel","status":"source_implemented","evidenceTier":"design","external":false,"closesWhen":["LegacyStableJsonV1 corpus is frozen","Node oracle and Rust verifier achieve zero unexplained drift","the hosted 263-file replay remains separately bound to LEGACY-REPLAY-001"]},{"id":"GAP-RO-001","title":"Schema-25 read-only Rust control plane","status":"source_implemented","evidenceTier":"design","external":false,"closesWhen":["immutable SQLite readers and normalized state projections are complete","no WAL sidecar or write path is opened"]},{"id":"GAP-MVP-001","title":"One-paper fake-provider author/reviewer local vertical slice","status":"source_implemented","evidenceTier":"design","external":false,"closesWhen":["fake-provider prepared results traverse workspace and read-only campaign projection","crash, cancel, replay and duplicate-integration source tests pass","real-provider qualification remains separately bound to GAP-CODEX-001"]},{"id":"GAP-DB-001","title":"Single-writer Rust campaign persistence and cutover fencing","status":"source_implemented","evidenceTier":"design","external":false,"closesWhen":["DB-001 through DB-009 source contracts and deterministic simulations pass","raw read-write open paths remain unreachable and signed cutover binding is enforced","real 72-hour target-host soak remains separately bound to GAP-HOST-002"]},{"id":"GAP-REL-001","title":"Release, KMS/HSM, WORM and submission authorities","status":"blocked_external","evidenceTier":"none","external":true,"issue":22,"repositoryLocalStatus":"source_implemented","closesWhen":["narrow receipt-verifying ports remain source-implemented and exact-head qualified by workflow evidence","real external authorities issue independently verifiable receipts","model principals retain zero key-custody, portal or submission access"]}],"qualificationCandidate":{"branch":"codex/rust-plan-v4-rc1-20260831","binding":"exact_head_workflow_evidence","evidenceTier":"source","productionAuthority":false},"supplementalBlockers":[{"id":"LEGACY-REPLAY-001","title":"Trusted 263-file legacy control-plane hosted replay","status":"blocked_external","issue":28,"external":true,"evidenceTier":"none","repositoryLocalStatus":"source_implemented","closesWhen":["the private companion workflow runs against the exact public candidate and exact archive/matrix digests","the retained receipt and artifact index prove 263/263 replay, network isolation and cleanup","an independent archive/replay reviewer acknowledges the exact evidence"]}],"knownQualificationDefects":[{"id":"QUAL-001","title":"Exact base repository/ref/commit/tree is not completely bound in V2 qualification identity","state":"design_ready"},{"id":"QUAL-002","title":"Tested synthetic merge commit/tree is not completely bound in V2 qualification identity","state":"design_ready"},{"id":"QUAL-003","title":"A later rerun of an older eligible run can be ignored after a newer run ID exists","state":"design_ready"},{"id":"QUAL-004","title":"Base/merge and complete eligible-run-history adversarial cases require implementation and fresh exact-head review","state":"design_ready"}]}
paper-core/tests/qualification-subject-v3-canonical-gate.test.mjs:22:  assert.match(runner, /derive-effective-status\.py/u);
paper-core/tests/qualification-subject-v3-canonical-gate.test.mjs:23:  assert.match(runner, /effective-status\.v1\.json/u);
paper-core/tests/qualification-subject-v3-canonical-gate.test.mjs:25:  assert.match(runner, /effective-status\.v2\.json/u);
paper-core/tests/qualification-subject-v3-governance.test.mjs:52:    'docs/rust/qualification/effective-status-runtime-v2.schema.json',

```
