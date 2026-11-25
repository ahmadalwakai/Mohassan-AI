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
