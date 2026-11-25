# Arbiter brain verification

The comparison base is release candidate commit `d3ebd9223f44445627b9d3d0bdea08d5f9b0550a`. The arbiter belongs to the model relations manager. An existing component still handles each turn.

## Decision sites

| Decision | Candidate sources | Activation flag |
| --- | --- | --- |
| Routing | Qualified existing handlers and adopted scratch routing decisions | `MOHASSAN_ARBITER_ROUTING` |
| Question rewrite | Validated rewrite and the original eligible public query | `MOHASSAN_ARBITER_QUESTION_REWRITE` |
| Local computation | Reasoning result and the native calculator result | `MOHASSAN_ARBITER_LOCAL_COMPUTATION` |
| Compound plan | Compiled plan and the available direct handler | `MOHASSAN_ARBITER_COMPOUND_PLAN` |

Each activation flag requires a promoted decision type in the manager. Add `_KILL=1` to the flag name to restore the current precedence even if that type was promoted. `MOHASSAN_MODEL_RELATIONS=off` opts out of the relations manager. Refusal, account authorization and approval checks keep their authority.

The scorer is a regularized logistic model initialized from zero. Input features include claimant identity, any supplied score or label, language, bounded request length, conversation state and available states from the model registry. The case-family split holds the same family together. The trainer evaluates calibration on the held-out families and reports proposed changes. The choice operation uses CPU arithmetic and can fall back when the artifact or a relevant model is absent.

The owner command `npm run models:shadow-summary -- .data/model-relations-shadow.jsonl` summarizes decisions by type, reason and proposed transition. Individual entries carry labels, scores and timing metadata without prompt or answer text.

## Development data

The v1 development fixture at #22 has 240 cases with `provenance.author: agent`. Its README marks every case evaluation-only. The human v2 development fixture at #62 has 2,400 cases. The published #70 filter includes the v2 development and sealed exclusion indexes and rejects rows by native source ID or normalized text hash. A v2 development case matches its own source ID. Applying those rules leaves zero eligible cases for training or calibration across the two development splits. [V1 provenance](https://github.com/ahmadalwakai/Mohassan-AI/blob/a258b3d47e39b5a2c03c71d4a9eb01107ae3d97f/tests/fixtures/agent-capability-bench/README.md) · [V2 development](https://github.com/ahmadalwakai/Mohassan-AI/pull/62) · [Exclusion audit](https://github.com/ahmadalwakai/Mohassan-AI/pull/70)

Development replay can still measure which components could pass the published scorer. It runs with fixture services and the documented release flags. Only eligible replay rows may reach model fitting. Replay receipts omit prompt and answer text. The release candidate's previously published scores are independent of this comparison. [Release verification protocol](RELEASE-CANDIDATE-2026-11-25.md#development-and-sealed-harness)

| Development split | Cases inspected | Human-authored | Matched PR #70 | Eligible |
| --- | ---: | ---: | ---: | ---: |
| V1 | 240 | 0 | 0 | 0 |
| V2 | 2,400 | 2,400 | 2,400 | 0 |

The v2 seal has already been used by several frozen candidates. A fresh sealed set would make the next claim stronger.

## Promotion

A decision type needs independently calibrated confidence and a paired run on both development splits before promotion. Each area and language must hold in each split. The release starts with every type in shadow. Sealed evaluation is conditional on promotion.

## Release baseline

The detached release candidate reproduced the published development totals and every published area and language count. Both splits use the release flags from the runbook, fixture tools, Node 24.22.3, Chromium 1248, and a network-disabled container with an unprivileged account and root-owned Python 3.12.14. V1 runs in one process. V2 uses the pinned index-modulo-eight lane assignment, one lane at a time.

| Split | Passes | Receipt SHA-256 |
| --- | ---: | --- |
| V1 | 176/240 | `5116b63d1bd38c2ef9074a6f15ff5abb93a0846b55f1ae069e718c30c0c819ed` |
| V2 | 1,588/2,400 | `43f47b18971b1e4d92e6ee4eec3a99b1ee379796e2006fa1b9566dff2f888d4f` |

The initial v1 run scored 169/240 because the container UID's home resolved to `/` and the desktop fixture adapter could not normalize folder paths. A service account with a normal home restored the seven desktop passes. The same initial run's v2 split reproduced the published counts.

The first v1 shadow replay at `4550e5a8ea3c2370d63b04aaa3ede624afca301c` matched all 240 baseline scorer signatures. It found 19 contested sites and scored all 38 forced choices. No alternative recovered a failing case. The 19 synchronous timings had a p95 of 1.088 ms, so extra candidate discovery was moved into existing post-publication observation for default shadow operation.

## Shadow latency

The measured implementation is `28e4ac347ce8febef37392c91f4eb273970f2bc9`. Default shadow queues additional candidate discovery and completes that work in the existing post-publication observer. A scoped replay collects synchronously so it can force an eligible choice before dispatch. The critical-path and replay timings use different boundaries.

| Measurement | Samples | p95 |
| --- | ---: | ---: |
| Default shadow enqueue, warmed focused test | 4,000 | 0.003 ms |
| Manager scoring with a test artifact, warmed focused test | 4,000 | 0.090 ms |
| Default shadow publication hook, full v1 development | 279 | 0.147 ms |
| Background arbitration in the default shadow v1 run | 19 | 0.600 ms |
| Scoped v1 replay arbitration | 19 | 0.463 ms |

The normal v1 shadow run matched every baseline scorer signature. Its owner summary recorded 17 compound-plan contests and two rewrite contests. Each reported an untrained scorer, with zero disagreements or changes. The final scoped replay also matched every v1 baseline scorer signature and reproduced all 38 forced outcomes. Fourteen alternatives lost an existing pass, two tied a pass, and three left an existing failure.

The v1 normal shadow receipt is `2d3cd611cc195ddea25cfe43b734759f109e14470ac9beec5ecc46a1c6a02175`. The v1 scoped replay receipt is `33f19b9412d0f5c8393ef1e99de94be05dbbff453ae71b333a2d4e3a2302b3c3`. The v1 runs used a separate worktree and lower CPU priority while one v2 lane ran. Live promotion latency is unverified.

## Merge notes

- `apps/server/src/command-chat.ts` adds two lines and deletes one to bind arbiter observation to the existing run. This is the only held-file hook.
- The branch adds no schema migration, benchmark payload, or model weights. The Mind C and pinned execution trees have empty diffs against the release candidate.

## Benchmark commands

The runner uses the published fixtures, adapters and scorer. The release baseline turns the relations manager off as documented. Replay uses the same wave flags, scorer and fixture services, with per-case in-process overrides. Each forced trial starts the full case again and checks that the declared claimant actually won at that turn and site. A case with several contested sites contributes at most one additional pass to the overall oracle. The oracle reports the best observed single forced choice per case.

The following commands exited 0 for both baseline splits and for the v1 shadow and replay runs. The combined baseline run's initial v1 result was discarded after diagnosing the home-directory mismatch. Its v2 result is retained.

```bash
node scripts/arbiter-bench/prepare.mjs /workspace/Mohassan-Arbiter-Base
docker run --rm --network none --user 1000:1000 --cap-drop ALL --security-opt no-new-privileges --env PLAYWRIGHT_BROWSERS_PATH=/workspace/work/arbiter-bench/chromium --env TEST_DRIVEN_CODING_PYTHON=/usr/local/bin/python3 --volume /workspace:/workspace --workdir /workspace/Mohassan-Arbiter-Base mohassan-arbiter-bench node --import tsx /workspace/Mohassan-AI/scripts/arbiter-bench/run.mjs /workspace/Mohassan-Arbiter-Base base /workspace/work/arbiter-bench/rc-base
docker run --rm --network none --user 1000:1000 --cap-drop ALL --security-opt no-new-privileges --env PLAYWRIGHT_BROWSERS_PATH=/workspace/work/arbiter-bench/chromium --env TEST_DRIVEN_CODING_PYTHON=/usr/local/bin/python3 --volume /workspace:/workspace --workdir /workspace/Mohassan-Arbiter-Base mohassan-arbiter-bench nice -n 10 node --import tsx /workspace/Mohassan-AI/scripts/arbiter-bench/run.mjs /workspace/Mohassan-Arbiter-Base base /workspace/work/arbiter-bench/rc-base-v1 --v1
node scripts/arbiter-bench/prepare.mjs /workspace/Mohassan-Arbiter-After --capture
node scripts/arbiter-bench/prepare.mjs /workspace/Mohassan-Arbiter-Shadow --capture
docker run --rm --network none --user 1000:1000 --cap-drop ALL --security-opt no-new-privileges --env PLAYWRIGHT_BROWSERS_PATH=/workspace/work/arbiter-bench/chromium --env TEST_DRIVEN_CODING_PYTHON=/usr/local/bin/python3 --volume /workspace:/workspace --workdir /workspace/Mohassan-Arbiter-Shadow mohassan-arbiter-bench nice -n 10 node --import tsx /workspace/Mohassan-AI/scripts/arbiter-bench/run.mjs /workspace/Mohassan-Arbiter-Shadow shadow /workspace/work/arbiter-bench/final-shadow-v1 --v1
docker run --rm --network none --user 1000:1000 --cap-drop ALL --security-opt no-new-privileges --env PLAYWRIGHT_BROWSERS_PATH=/workspace/work/arbiter-bench/chromium --env TEST_DRIVEN_CODING_PYTHON=/usr/local/bin/python3 --volume /workspace:/workspace --workdir /workspace/Mohassan-Arbiter-Shadow mohassan-arbiter-bench nice -n 10 node --import tsx /workspace/Mohassan-AI/scripts/arbiter-bench/run.mjs /workspace/Mohassan-Arbiter-Shadow replay /workspace/work/arbiter-bench/final-replay-v1 --v1
npm run -s models:shadow-summary -- /workspace/work/arbiter-bench/final-shadow-v1/default-shadow-log.jsonl
```
