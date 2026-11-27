// Real output of the repair demo's tests in the Windows AppContainer sandbox (Node 24), 2026-11-27; user folder renamed.
const work = 'file:///C:/Users/runner/AppData/Local/Temp/mohassan-sandbox-c1C0rp/work';
export const REAL_OUTPUT = [
  '', '✖ adds positive values (0.6578ms)', '✖ adds negative values (0.1019ms)', 'ℹ tests 2', 'ℹ suites 0', 'ℹ pass 0', 'ℹ fail 2', 'ℹ cancelled 0',
  'ℹ skipped 0', 'ℹ todo 0', 'ℹ duration_ms 54.9709', '', '✖ failing tests:', '', 'test at test\\sum.test.mjs:5:1', '✖ adds positive values (0.6578ms)',
  '  ReferenceError: rightHandVaule is not defined', `      at sum (${work}/src/sum.ts:2:26)`, `      at TestContext.<anonymous> (${work}/test/sum.test.mjs:5:49)`,
  '      at Test.runInAsyncScope (node:async_hooks:227:14)', '', 'test at test\\sum.test.mjs:6:1', '✖ adds negative values (0.1019ms)',
  '  ReferenceError: rightHandVaule is not defined', `      at sum (${work}/src/sum.ts:2:26)`, `      at TestContext.<anonymous> (${work}/test/sum.test.mjs:6:49)`, '',
].join('\n');

// Recorded from the corrected demo with Node 24's spec reporter.
export const PASSING_OUTPUT = [
  '✔ adds positive values (1.023158ms)', '✔ adds negative values (0.170356ms)', 'ℹ tests 2', 'ℹ suites 0', 'ℹ pass 2',
  'ℹ fail 0', 'ℹ cancelled 0', 'ℹ skipped 0', 'ℹ todo 0', 'ℹ duration_ms 183.516065', '',
].join('\n');

// Node 24 spec output for the subtraction variant after the spelling fix, with the temporary path and internal frames omitted.
export const ASSERTION_OUTPUT = [
  '✖ adds positive values (1.907187ms)', '✖ adds negative values (0.341534ms)', 'ℹ tests 2', 'ℹ suites 0', 'ℹ pass 0',
  'ℹ fail 2', 'ℹ cancelled 0', 'ℹ skipped 0', 'ℹ todo 0', 'ℹ duration_ms 161.056255', '', '✖ failing tests:', '',
  'test at test/sum.test.mjs:5:1', '✖ adds positive values (1.907187ms)',
  '  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:', '', '  -1 !== 5', '',
  '      at TestContext.<anonymous> (test/sum.test.mjs:5:43)', '',
  'test at test/sum.test.mjs:6:1', '✖ adds negative values (0.341534ms)',
  '  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:', '', '  -4 !== -2', '',
  '      at TestContext.<anonymous> (test/sum.test.mjs:6:43)', '',
].join('\n');
