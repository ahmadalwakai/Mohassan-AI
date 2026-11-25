# Arbiter brain verification

The comparison base is release candidate commit `d3ebd9223f44445627b9d3d0bdea08d5f9b0550a`. The arbiter belongs to the model relations manager. An existing component still handles each turn.

## Development data

The v1 development fixture at #22 has 240 cases with `provenance.author: agent`. Its README marks every case evaluation-only. The human v2 development fixture at #62 has 2,400 cases. The published #70 filter includes the v2 development and sealed exclusion indexes and rejects rows by native source ID or normalized text hash. A v2 development case matches its own source ID. Applying those rules leaves zero eligible cases for training or calibration across the two development splits. [V1 provenance](https://github.com/ahmadalwakai/Mohassan-AI/blob/a258b3d47e39b5a2c03c71d4a9eb01107ae3d97f/tests/fixtures/agent-capability-bench/README.md) · [V2 development](https://github.com/ahmadalwakai/Mohassan-AI/pull/62) · [Exclusion audit](https://github.com/ahmadalwakai/Mohassan-AI/pull/70)

Development replay can still measure which components could pass the published scorer. It runs with fixture services and the documented release flags. Only eligible replay rows may reach model fitting. Replay receipts omit prompt and answer text. The release candidate's previously published scores are independent of this comparison. [Release verification protocol](RELEASE-CANDIDATE-2026-11-25.md#development-and-sealed-harness)

The v2 seal has already been used by several frozen candidates. A fresh sealed set would make the next claim stronger.

## Promotion

A decision type needs independently calibrated confidence and a paired run on both development splits before promotion. Each area and language must hold in each split. The release starts with every type in shadow. Sealed evaluation is conditional on promotion.
