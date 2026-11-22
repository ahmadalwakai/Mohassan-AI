---
name: Verify before you say done
description: Check real evidence before claiming work is complete, a bug is fixed or tests pass: name the command that proves the claim, run it in full, read the output, then report with evidence. Keywords: verify before done, verification before completion, evidence before claims, run tests before commit, is it really fixed
category: coding
version: 1.0.0
language: en
workflow: verify-before-done
variant-of: verify-before-done
license: MIT
source: openai/plugins@981b02c0c44058b595f3b4180002c3ae3c806d40:plugins/superpowers/skills/verification-before-completion/SKILL.md
source-sha256: 2befe7fc55bcadaa3d97dd9e8efeb633d2561c0ebe74c5a8b17c4d9e7e4520b3
attribution: Adapted from "verification-before-completion" from obra/superpowers by Jesse Vincent (MIT), as packaged in openai/plugins. Changed: rewritten as a short English playbook; bundled scripts and examples not included.
---
Evidence before claims, always.

## When to use
- Before saying "done", "fixed" or "tests pass", and before merging or handing over.

## What I need from you
- The exact claim, and where it can be measured.

## Steps
1. Name the command that proves the claim: a test, a build or a real run.
2. Run it in full now; not an old result, not a part of it.
3. Read the whole output: exit code, failure count, warnings.
4. Compare: does the output prove this exact claim?
5. If it does not, state the actual status with the evidence.
6. If it does, state the result with the evidence.

## Answer shape
- The claim, the command that ran, the actual result, the decision.

## Checks
- Did the command run after the last change?

## Pitfalls
- "Should work" and "probably" instead of running it.
- Celebrating before reading the output.
