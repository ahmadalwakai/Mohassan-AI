// Recorded by the Windows AppContainer checks for the repair demo, 2026-11-27.
// The temporary directory is represented as /fixture in this recording.
export const REPAIR_DEMO_FAILURE_OUTPUT = `
✖ adds positive values (0.6578ms)
✖ adds negative values (0.1019ms)
ℹ tests 2
ℹ suites 0
ℹ pass 0
ℹ fail 2
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 54.9709

✖ failing tests:

test at test\\sum.test.mjs:5:1
✖ adds positive values (0.6578ms)
  ReferenceError: rightHandVaule is not defined
      at sum (file:///fixture/src/sum.ts:2:26)
      at TestContext.<anonymous> (file:///fixture/test/sum.test.mjs:5:49)
      at Test.runInAsyncScope (node:async_hooks:227:14)
      at Test.run (node:internal/test_runner/test:1402:25)

test at test\\sum.test.mjs:6:1
✖ adds negative values (0.1019ms)
  ReferenceError: rightHandVaule is not defined
      at sum (file:///fixture/src/sum.ts:2:26)
      at TestContext.<anonymous> (file:///fixture/test/sum.test.mjs:6:49)
      at Test.runInAsyncScope (node:async_hooks:227:14)
`;

// Recorded by Node 24 on the repaired demo. The fixture runner replays stdout only.
export const REPAIR_DEMO_SUCCESS_OUTPUT = `✔ adds positive values (0.952946ms)
✔ adds negative values (0.169962ms)
ℹ tests 2
ℹ suites 0
ℹ pass 2
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 409.416589
`;

// Recorded summary from Node 24 on the repaired demo with subtraction still in its implementation.
export const REPAIR_DEMO_ASSERTION_FAILURE_OUTPUT = `✖ adds positive values (2.715046ms)
✖ adds negative values (0.449734ms)
ℹ tests 2
ℹ suites 0
ℹ pass 0
ℹ fail 2
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 193.934497
`;
