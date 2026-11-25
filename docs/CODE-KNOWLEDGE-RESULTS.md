# Offline programming knowledge evaluation

The 15 public held-out questions produced **1 scripted correct answer, 7 wrong answers, and 7 abstentions**. The implementation is available through the local CLI and shadow adapter. Source activation requires a separate owner decision. [Source decision](CODE-KNOWLEDGE-DECISION.md)

## Corpus

The run used Node.js `v24.22.3` and the frozen answerer at `ad06e4752e83b62b80ec0c8c34bc9e81d0cf128b`. The local corpus contained 9,081 passages. Its SHA-256 was `903483e099e66d1090e0e0ecba2fa569fc36aab0f592b5d440f061a74a4a23c6`.

| Source | Version | Passages |
| --- | --- | ---: |
| MDN Web Docs | `72813e874d34cf328f39ab025448d9e06d921254` | 755 |
| Python documentation | `3.13.9` | 2,366 |
| Node.js documentation | `v22.21.1` | 2,564 |
| TypeScript Handbook v2 and reference | `cf57c7ec6762f3cae3a9ebc973e63851d88cb2a8` | 289 |
| DevOps Stack Exchange | April 2024 | 607 |
| Database Administrators Stack Exchange | April 2024 | 2,500 |

The archive runs exercised the DevOps download path and the DevOps and DBA XML import. Stack Overflow and Unix & Linux are supported by the importer configuration. Their full archives were outside this run. The corpus and downloaded archives are local build artifacts.

## Public human-written questions

Each split contains 15 verbatim Stack Overflow titles with question and revision attribution verified against the Stack Exchange API. The scorer requires every expected evidence group to occur in a selected explanation or code snippet. The table uses the labelled question type. The evaluator excludes all 30 original threads from the search corpus when present. Zero passages were excluded in this run because the measured archives were from other Stack Exchange sites. [Question provenance, split fingerprints and scoring rules](../scripts/code-knowledge/questions/README.md)

| Question type | Held-out correct | Held-out wrong | Held-out abstained | Development correct | Development wrong | Development abstained |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| How-to | 0 | 3 | 0 | 0 | 3 | 0 |
| Error | 0 | 1 | 2 | 0 | 1 | 2 |
| API usage | 0 | 1 | 2 | 3 | 0 | 0 |
| Concept | 1 | 2 | 0 | 0 | 3 | 0 |
| Comparison | 0 | 0 | 3 | 0 | 2 | 1 |
| **Total** | **1** | **7** | **7** | **3** | **9** | **3** |

The check measures whether selected evidence contains the expected literals. Snippet execution and complete semantic correctness are outside the scripted check. Some titles omit a language or other context present in the original question body. The sample covers JavaScript, Node.js, Python and TypeScript. It leaves Arabic retrieval quality and shell, SQL, and other framework coverage unmeasured by the public set.

## Capability benchmark coding area

The benchmark replay ran all 20 coding cases from [PR #22](https://github.com/ahmadalwakai/Mohassan-AI/pull/22) at `a258b3d47e39b5a2c03c71d4a9eb01107ae3d97f`. It used the original controller harness and scorer. The replay replaced the observed reply text with the formatted shadow answer and retained the observed controller evidence, including routing, tools and verification. The excerpt-only check used the original required and forbidden content checks on the selected source text and code. The adapter recorded 20 shadow events.

| Partition | Cases | Baseline full passes | Shadow full passes | Excerpt-only correct | Excerpt-only wrong | Excerpt-only abstained |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Development | 16 | 0 | 0 | 2 | 10 | 4 |
| Sealed | 4 | 0 | 0 | 0 | 4 | 0 |
| **Total** | **20** | **0** | **0** | **2** | **14** | **4** |

The full shadow scorer recorded verification failures in all 20 cases and routing failures in 19. The full score covers controller behavior and outcomes beyond the answer text. The benchmark merge remained uncommitted in a separate detached worktree. The emitted capability JSON had SHA-256 `3bff6b1cd3d7f4df72a54bf47f6d907563734a2336b42a40aa2181406636a4c7`.

## Commands run

All commands below exited 0. Typecheck covered the root and web workspace. The focused suite passed 39 tests across five files. The two public jobs scored all 15 cases in each split. The import commands produced the 9,081-passage corpus and a separate 10-passage live download check.

```bash
npm run typecheck
npm test -- tests/code-knowledge-*.test.ts
git diff c2a0ff7..HEAD --check
NODE_USE_ENV_PROXY=1 npx tsx scripts/code-knowledge/import.ts --output /workspace/scratch/code-knowledge/corpus.json --stack-site devops --stack-site dba --stack-limit 2500 --stack-cache /workspace/scratch/code-knowledge-tooling --seven-zip /workspace/scratch/code-knowledge-tooling/current/7zz
NODE_USE_ENV_PROXY=1 npx tsx scripts/code-knowledge/import.ts --docs none --output /workspace/scratch/code-knowledge/devops-download/corpus.json --stack-site devops --stack-limit 10 --seven-zip /workspace/scratch/code-knowledge-tooling/current/7zz
./node_modules/.bin/tsx scripts/code-knowledge/evaluate.ts --corpus /workspace/scratch/code-knowledge/corpus.json --split development --output /workspace/scratch/code-knowledge/development.json > /workspace/scratch/code-knowledge/development.log
./node_modules/.bin/tsx scripts/code-knowledge/evaluate.ts --corpus /workspace/scratch/code-knowledge/corpus.json --split held-out --output /workspace/scratch/code-knowledge/held-out.json > /workspace/scratch/code-knowledge/held-out.log
```

The following ran in the prepared scratch worktree at `/workspace/scratch/code-knowledge-capability`.

```bash
git switch --detach ad06e4752e83b62b80ec0c8c34bc9e81d0cf128b && git -c user.name=Codex -c user.email=codex@openai.com merge --no-commit --no-ff origin/feat/agent-capability-bench && git rev-parse HEAD MERGE_HEAD && sha256sum /workspace/scratch/code-knowledge/corpus.json
./node_modules/.bin/tsx scripts/code-knowledge/capability.ts --corpus /workspace/scratch/code-knowledge/corpus.json --output /workspace/scratch/code-knowledge/capability.json --sealed
```

The two CLI checks below exited 0. The first returned the MDN definition and CC0 example for `Promise.allSettled`. The second returned the Node.js `server.listen` retry example for `EADDRINUSE` with its version and MIT license.

```bash
./node_modules/.bin/tsx scripts/code-knowledge/ask.ts --corpus /workspace/scratch/code-knowledge/corpus.json 'What does Promise.allSettled return?' > /workspace/scratch/code-knowledge/doc-smoke.md && rg -n 'Promise\.allSettled|MDN|CC-BY-SA|CC0' /workspace/scratch/code-knowledge/doc-smoke.md
printf '%s\n' 'Error: listen EADDRINUSE' | ./node_modules/.bin/tsx scripts/code-knowledge/ask.ts --corpus /workspace/scratch/code-knowledge/corpus.json --error > /workspace/scratch/code-knowledge/error-smoke.md && rg -n 'Node\.js documentation|v22\.21\.1|EADDRINUSE|server\.listen' /workspace/scratch/code-knowledge/error-smoke.md
```
