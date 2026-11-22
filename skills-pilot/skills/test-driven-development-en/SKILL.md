---
name: Test-driven development (TDD)
description: Write code test first: a failing test, the least code that passes it, then refactor, for every feature, bug fix or behaviour change. Keywords: tdd, test driven development, red green refactor, failing test first, write the test before the code, unit test first
category: coding
version: 1.0.0
language: en
workflow: test-driven-development
variant-of: test-driven-development
license: MIT
source: openai/plugins@981b02c0c44058b595f3b4180002c3ae3c806d40:plugins/superpowers/skills/test-driven-development/SKILL.md
source-sha256: bf1b8216e523851a411e91d429a7c1c2a173e79d88957bc78e348218d50edd54
attribution: Adapted from "test-driven-development" from obra/superpowers by Jesse Vincent (MIT), as packaged in openai/plugins. Changed: rewritten as a short English playbook; bundled scripts and examples not included.
---
If you did not watch the test fail, you do not know that it tests the right thing.

## When to use
- Every new feature, bug fix or behaviour change.
- Exceptions only when agreed: throwaway prototypes, configuration files.

## What I need from you
- The behaviour wanted, as an example input and result.
- The test framework of your project.

## Steps
1. Red: write one test for the behaviour.
2. Run it and confirm it fails for the expected reason, not a typo.
3. Green: write the least code that makes it pass, nothing more.
4. Run the whole suite and confirm it passes.
5. Refactor without changing behaviour, keeping the suite green.
6. Repeat for the next behaviour.
7. If code came before its test, delete it and start from the test.

## Answer shape
- For each behaviour: the failing test, the minimal code, the refactor.

## Checks
- Did every new test fail before it passed?

## Pitfalls
- Writing the test after the code to confirm what was written.
- One test checking two behaviours.
