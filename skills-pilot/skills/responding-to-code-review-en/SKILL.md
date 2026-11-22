---
name: Responding to code review feedback
description: Handle review comments as the author of the code: understand each comment, verify it against the code, accept it or push back with technical reasons, then apply the accepted ones one at a time with tests. Keywords: respond to code review feedback, review comments, pull request reviewer, push back on a review, apply review suggestions
category: coding
version: 1.0.0
language: en
workflow: responding-to-code-review
variant-of: responding-to-code-review
license: MIT
source: openai/plugins@981b02c0c44058b595f3b4180002c3ae3c806d40:plugins/superpowers/skills/receiving-code-review/SKILL.md
source-sha256: 091df1629510af1b92fc4abd6f96732ebedb4cb2c0f3457e8f2740b0504a2438
attribution: Adapted from "receiving-code-review" from obra/superpowers by Jesse Vincent (MIT), as packaged in openai/plugins. Changed: rewritten as a short English playbook; bundled scripts and examples not included.
---
Technical correctness over social comfort.

## When to use
- When review comments arrive on a pull request, especially unclear or doubtful ones.

## What I need from you
- The comments as written, and the code they refer to.

## Steps
1. Read all the comments before answering any of them.
2. Restate each comment in your own words; ask when it is unclear.
3. Verify it against the actual code: is the problem really here?
4. Evaluate it for this project: is the change technically right here?
5. Reply with a specific technical acknowledgement, or push back with the reason and evidence.
6. Apply accepted comments one at a time, testing after each.

## Answer shape
- A table: comment, your reading of it, decision (accept, push back, ask), reason.

## Checks
- Does every comment have a justified decision?

## Pitfalls
- Agreeing with everything without checking.
- Applying all comments in one go without tests.
